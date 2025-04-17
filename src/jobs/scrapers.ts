import axios from "axios";
import { load } from "cheerio";
import puppeteer from "puppeteer";

// Common interface for all scraped jobs
export interface ScrapedJob {
  title: string;
  company: string;
  location: string[];
  description?: string;
  url: string;
  tags?: string[];
  source: string;
  salary?: {
    min?: number;
    max?: number;
    estimated?: boolean; // Indicates if the salary is estimated
    currency?: string;
  };
  postedDate?: Date;
  scrapedDate?: Date; // Added field for tracking when job was scraped
}

/**
 * Scrapes jobs from landing.jobs
 */
export async function scrapeLandingJobs(url?: string): Promise<ScrapedJob[]> {
  let page = 1;
  const allJobs: ScrapedJob[] = [];

  while (true) {
    try {
      // Construct the URL for the current page
      url = `https://landing.jobs/jobs/search.json?page=${page}&match=all&country=&hd=false&t_co=false&t_st=false`;

      // Fetch the page JSON data
      const { data } = await axios.get(url, {
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 OPR/117.0.0.0",
          "x-csrf-token":
            "cb6c8mOO3NC93hQ9ta3OtCvW/qroT9EhAVKDF7j58yRhjLYegrc5NXbRHvlhR3WUVUu5jmCATyfy8rBgw+c/lg==",
        },
      });

      // Check if we have any job offers
      const offers = data.offers;
      if (!offers || offers.length === 0) {
        break; // No more jobs found, stop pagination
      }

      // Loop through each job and add it to the result
      for (const offer of offers) {
        // Extract the basic details for the job
        const job = {
          title: offer.title,
          company: offer.company_name,
          location: [offer.location || "Remote"],
          url: offer.url,
          source: "landing.jobs",
          postedDate: new Date(offer.published_at),
          scrapedDate: new Date(),
          description: "", // Placeholder, will update this later
          tags: offer.skills.map((skill: any) => skill.name),
        };

        // Fetch the detailed job page to extract additional data
        const jobPageData = await fetchJobDetails(job.url);

        // Merge the detailed data with the basic job data
        if (jobPageData) {
          job.description = jobPageData.description;
        }

        // Add the job to the result list
        allJobs.push(job);
      }

      page += 1; // Move to the next page if there are more jobs
    } catch (error) {
      console.error("Error fetching landing.jobs API:", error);
      break;
    }
  }

  console.log(`Scraped ${allJobs.length} jobs from landing.jobs`);
  return allJobs;
}

/**
 * Fetches the detailed job data from the individual job page.
 */
async function fetchJobDetails(url: string) {
  try {
    // Fetch the HTML content of the job detail page
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobScraper/1.0)" },
    });

    // Load the page HTML into Cheerio
    const $ = load(data);

    // Extract the second ld+json block containing the detailed job posting data
    const jsonLdScript = $('script[type="application/ld+json"]').eq(1).html();

    if (jsonLdScript) {
      const jobData = JSON.parse(jsonLdScript);

      // Extract relevant details from the JSON-LD data
      return {
        description: jobData.description || "",
        skills: jobData.skills || [],
        experience: jobData.experienceRequirements
          ? jobData.experienceRequirements.monthsOfExperience
          : null,
        jobType: jobData.employmentType || "",
      };
    } else {
      throw new Error("Detailed job data not found");
    }
  } catch (error) {
    console.error(`Error fetching job details for URL ${url}:`, error);
    return null;
  }
}

/**
 * Scrapes jobs from WeWorkRemotely
 * HTML-based scraper
 */
export async function scrapeWeWorkRemotely(url: string): Promise<ScrapedJob[]> {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2" });

    const jobLinks = await page.evaluate(() => {
      const results: {
        title: string;
        company: string;
        location: string;
        url: string;
        tags: string[];
        postedAt?: string;
      }[] = [];

      const listings = document.querySelectorAll(
        "section.jobs li.new-listing-container"
      );

      listings.forEach((el) => {
        const anchor = el.querySelectorAll("a")[1];
        const rawHref = anchor?.getAttribute("href") || "";
        if (!rawHref.startsWith("/remote-jobs/")) return;

        const jobURL = `https://weworkremotely.com${rawHref}`;
        const title =
          el
            .querySelector("h4.new-listing__header__title")
            ?.textContent?.trim() || "";
        const company =
          el
            .querySelector("p.new-listing__company-name")
            ?.textContent?.trim() || "";
        const location =
          el
            .querySelector("p.new-listing__company-headquarters")
            ?.textContent?.trim() || "Remote";

        const tags: string[] = [];
        el.querySelectorAll(".new-listing__categories__category").forEach(
          (tagEl) => {
            const tag = tagEl.textContent?.trim();
            if (tag) tags.push(tag);
          }
        );

        const postedAtText =
          el
            .querySelector(".new-listing__header__icons__date")
            ?.textContent?.trim() || "";
        let postedAt: string | undefined = undefined;
        const daysAgo = parseInt(postedAtText.replace(/[^\d]/g, ""), 10);
        if (!isNaN(daysAgo)) {
          const date = new Date(Date.now() - daysAgo * 86400000);
          postedAt = date.toISOString();
        }

        if (title && company) {
          results.push({
            title,
            company,
            location,
            url: jobURL,
            tags,
            postedAt,
          });
        }
      });

      return results;
    });

    const jobs: ScrapedJob[] = [];

    for (const job of jobLinks) {
      try {
        const jobPage = await browser.newPage();
        await jobPage.goto(job.url, { waitUntil: "networkidle2" });

        const description = await jobPage.evaluate(() => {
          console.log("herex");
          const blocks: string[] = [];
          document
            .querySelectorAll(
              ".lis-container__job__content__description div, p, li"
            )
            .forEach((el) => {
              const text = el.textContent?.trim();
              if (text) blocks.push(text);
            });

          return blocks.join("\n");
        });

        if (!description) {
          console.warn("Missing description for", job.url);
          continue;
        }

        jobs.push({
          ...job,
          description,
          location: job.location.includes(",")
            ? job.location.split(",").map((l) => l.trim())
            : [job.location],
          source: "WeWorkRemotely",
          scrapedDate: new Date(),
        });

        await jobPage.close();
      } catch (err) {
        console.warn("Failed to extract job detail from", job.url, err);
      }
    }

    console.log(
      `Scraped ${jobs.length} jobs from WeWorkRemotely with Puppeteer`
    );
    return jobs;
  } catch (err) {
    console.error("WWR Puppeteer scrape error:", err);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrapes jobs from Remotive
 * JSON API-based scraper (proxied to avoid Cloudflare 526 error)
 */
export async function scrapeRemotive(): Promise<ScrapedJob[]> {
  try {
    const originalUrl =
      "https://remotive.io/api/remote-jobs?category=software-dev";
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(
      originalUrl
    )}`;

    const response = await axios.get(proxyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBoardScraper/1.0)",
      },
    });

    const data = response.data;

    if (!data.jobs || !Array.isArray(data.jobs)) {
      console.error("Unexpected response format from Remotive API");
      return [];
    }

    const jobs: ScrapedJob[] = data.jobs.map((job: any) => ({
      title: job.title || "Unknown Position",
      company: job.company_name || "Unknown Company",
      location: job.candidate_required_location || "Remote",
      description: job.description,
      url: job.url || job.absolute_url,
      tags: job.tags || [],
      source: "Remotive",
      postedAt: job.publication_date || undefined,
      scrapedDate: new Date(),
    }));

    console.log(`Scraped ${jobs.length} jobs from Remotive`);
    return jobs;
  } catch (error) {
    console.error("Error scraping Remotive:", error);
    return [];
  }
}

/**
 * Scrapes jobs from RemoteOK
 * JSON API-based scraper
 */
export async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    // RemoteOK API requires a User-Agent header
    const url = "https://remoteok.com/api";
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBoardScraper/1.0)",
      },
    });

    // The first item is usually not a job but information about the API
    const jobsData = Array.isArray(response.data) ? response.data.slice(1) : [];

    const jobs: ScrapedJob[] = jobsData.map((job: any) => ({
      title: job.position || "Unknown Position",
      company: job.company || "Unknown Company",
      location: job.location || "Remote",
      description: job.description,
      url: job.url.startsWith("http")
        ? job.url
        : `https://remoteok.com${job.url}`,
      tags:
        job.tags?.length > 0
          ? job.tags.map((tag: string) => tag.toLowerCase().trim())
          : [],
      source: "RemoteOK",
      postedAt: job.date ? new Date(job.date).toISOString() : undefined,
      scrapedDate: new Date(), // Set the scraped date to the current date
    }));

    console.log(`Scraped ${jobs.length} jobs from RemoteOK`);
    return jobs;
  } catch (error) {
    console.error("Error scraping RemoteOK:", error);
    return [];
  }
}

/**
 * Scrapes jobs from JSRemotely
 * HTML-based scraper
 */
export async function scrapeJSRemotely(): Promise<ScrapedJob[]> {
  try {
    const url = "https://jsremotely.com/remote-javascript-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // JSRemotely typically has job listings in card-like structures
    $(".job-card, .job-listing, .job-item").each((_, element) => {
      const title = $(element).find(".job-title, h2, h3").first().text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const locationElement = $(element).find(".location, .job-location");
      const location = locationElement.length
        ? locationElement.text().trim()
        : "Remote";

      // Extract job URL
      const jobURL = $(element).find("a").attr("href") || "";
      const fullURL = jobURL.startsWith("http")
        ? jobURL
        : `https://jsremotely.com${jobURL}`;

      // Extract tags if available
      const tags: string[] = [];
      $(element)
        .find(".tags .tag, .skills span")
        .each((_, tagElement) => {
          tags.push($(tagElement).text().trim());
        });

      // Try to find posted date
      const postedAtText = $(element)
        .find(".date, .posted-date, .job-date")
        .text()
        .trim();
      let postedAt: Date | undefined = undefined;

      if (postedAtText) {
        try {
          postedAt = new Date(postedAtText);
        } catch (e) {
          // Invalid date format, ignore
        }
      }

      if (title && company && fullURL) {
        jobs.push({
          title,
          company,
          location: location.includes(",") ? location.split(",") : [location],
          url: fullURL,
          tags,
          source: "JSRemotely",
          postedDate: postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from JSRemotely`);
    return jobs;
  } catch (error) {
    console.error("Error scraping JSRemotely:", error);
    return [];
  }
}

/**
 * Scrapes jobs from ReactJobsBoard
 * HTML-based scraper
 */
export async function scrapeReactJobsBoard(): Promise<ScrapedJob[]> {
  try {
    const url = "https://reactjobsboard.com/remote-react-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // ReactJobsBoard typically has a structure of job cards
    $(".job-card, .job-item, article").each((_, element) => {
      const title = $(element).find(".job-title, h2, h3").first().text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const location = $(element).find(".location").text().trim() || "Remote";

      // Get job URL
      let jobURL = $(element).find("a").attr("href");
      // Ensure the URL is absolute
      if (jobURL && !jobURL.startsWith("http")) {
        jobURL = `https://reactjobsboard.com${jobURL}`;
      }

      // Extract tags
      const tags: string[] = [];
      $(element)
        .find(".tag, .skill, .technology")
        .each((_, tagEl) => {
          const tag = $(tagEl).text().trim();
          if (tag) tags.push(tag);
        });

      // Extract posted date if available
      const dateText = $(element).find(".date, .posted").text().trim();
      let postedAt: Date | undefined = undefined;

      if (dateText) {
        try {
          postedAt = new Date(dateText);
        } catch (e) {
          // Invalid date format
        }
      }

      if (title && company && jobURL) {
        jobs.push({
          title,
          company,
          location: location.includes(",") ? location.split(",") : [location],
          url: jobURL,
          tags,
          source: "ReactJobsBoard",
          postedDate: postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from ReactJobsBoard`);
    return jobs;
  } catch (error) {
    console.error("Error scraping ReactJobsBoard:", error);
    return [];
  }
}

/**
 * Scrapes jobs from NoDesk
 * HTML-based scraper
 */
export async function scrapeNoDesk(): Promise<ScrapedJob[]> {
  try {
    const url = "https://nodesk.co/remote-jobs/programming/";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // NoDesk typically displays jobs in a list
    $(".job-listing, .job-item, article").each((_, element) => {
      const titleElement = $(element).find(".job-title, h2, h3").first();
      const title = titleElement.text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const location =
        $(element).find(".location, .job-location").text().trim() || "Remote";

      // Get job URL
      const jobURL =
        titleElement.find("a").attr("href") ||
        $(element).find("a").attr("href");

      // Some job boards might have tags or categories
      const tags: string[] = [];
      $(element)
        .find(".tags span, .categories span, .skills span")
        .each((_, tagEl) => {
          tags.push($(tagEl).text().trim());
        });

      // Try to extract posting date
      const dateText = $(element).find(".date, .posted-date").text().trim();
      let postedAt: Date | undefined = undefined;

      if (dateText) {
        try {
          postedAt = new Date(dateText);
        } catch (e) {
          // Invalid date format
        }
      }

      if (title && company && jobURL) {
        jobs.push({
          title,
          company,
          location: location.includes(",") ? location.split(",") : [location],
          url: jobURL,
          tags,
          source: "NoDesk",
          postedDate: postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from NoDesk`);
    return jobs;
  } catch (error) {
    console.error("Error scraping NoDesk:", error);
    return [];
  }
}
